// Unit tests of the sema lexer for the parts the corpus cross-check does not see: decoded values (strings, templates,
// names with escapes, numbers, bigints, JSX text), rescans, marks, comments and directives.   node tools/lex-unit.ts
import { Lexer } from "../src/sema/parser/lexer.ts";
import { Names } from "../src/sema/parser/names.ts";
import {
  T_BIG_INT, T_CLOSE_BRACE, T_EOF, T_GREATER_THAN, T_GREATER_THAN_GREATER_THAN, T_GREATER_THAN_GREATER_THAN_GREATER_THAN_EQUALS, T_IDENTIFIER,
  T_JSX_TEXT, T_NO_SUBSTITUTION_TEMPLATE, T_NUMBER, T_PRIVATE_IDENTIFIER, T_REGEX, T_SLASH, T_STRING, T_TEMPLATE_HEAD, T_TEMPLATE_MIDDLE,
  T_TEMPLATE_TAIL, T_LESS_THAN, T_CONST, T_FUNCTION, T_AWAIT, T_LESS_THAN_SLASH, T_ESCAPED_RESERVED_WORD, T_DEFAULT, T_OPEN_BRACE,
} from "../src/sema/parser/token.ts";
import { R_INVALID_ESCAPE, R_UNTERMINATED, R_UNUSUAL_NUMBER, DIALECT_ECMASCRIPT, DIALECT_TYPESCRIPT_5 } from "../src/sema/parser/lib.ts";
import { A_default, A_empty, A_constructor, ATOM_FIXED, A_NewableFunction, A_LibraryManagedAttributes, A_ElementAttributesProperty } from "../src/sema/atom.ts";

let failures = 0;
let checks = 0;
function eq(name: string, got: unknown, want: unknown): void {
  checks++;
  if (got !== want) {
    failures++;
    console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want));
  }
}

const names = new Names();
const lx = new Lexer(names);
function setup(text: string, jsx: boolean = false, dialect: number = DIALECT_TYPESCRIPT_5): Buffer {
  const b = Buffer.from(text, "utf8");
  const big = Buffer.alloc(b.length + 16);
  b.copy(big);
  lx.begin(big, b.length);
  lx.configure(dialect, jsx, false, false, false);
  lx.next();
  return big;
}
function atomText(): string {
  return names.atomString(lx.atom);
}

// ───── strings: decoded value = what JS evaluates ─────
// [literal as written in the source, the value JavaScript gives it]
const strings: string[][] = [
  ["'abc'", "abc"],
  ['"a\\nb"', "a\nb"],
  ["'\\t\\r\\v\\f\\b\\0'", "\t\r\v\f\b\0"],
  ["'\\x41\\u0042\\u{43}\\u{1F600}'", "ABC\u{1F600}"],
  ["'caf\u00e9 \u4e2d\u6587 \u{1F600}'", "caf\u00e9 \u4e2d\u6587 \u{1F600}"],
  ["'a\\\nb'", "ab"],
  ["'it\\'s'", "it's"],
  ['"say \\"hi\\""', 'say "hi"'],
  ["'\\\\'", "\\"],
  ["''", ""],
  ["'\\u{10FFFF}'", "\u{10FFFF}"],
  ["'\u2028'", "\u2028"],
];
for (let i = 0; i < strings.length; i++) {
  const lit = strings[i][0];
  setup(lit);
  const want = strings[i][1];
  eq("string token " + lit, lx.token, T_STRING);
  eq("string value " + lit, atomText(), want);
  eq("string end " + lit, lx.end, Buffer.byteLength(lit));
}

// ───── numbers ─────
const numbers = ["0", "1", "42", "1234567890123", "123456789012345678", "0.5", ".5", "5.", "1e3", "1E-3", "1.5e+10", "0x1F", "0Xff", "0o17", "0b101", "1_000", "0xFF_FF", "1_0.0_1e1_0", "0xFFFFFFFFFFFFFFFF", "9007199254740993", "0.1", "3.14159", "123456.789", "0.000001", "99999.9999999999", "0x7FFFFFFFFFFF", "0xFFFFFFFFFFFFF", "0.30000000000000004", "1.0", "100.00", "0.0"];
for (const lit of numbers) {
  setup(lit);
  eq("number token " + lit, lx.token, T_NUMBER);
  eq("number value " + lit, lx.number, Number(lit.replace(/_/g, "")));
  eq("number end " + lit, lx.end, lit.length);
}
const bigints = ["0n", "123n", "0xFFn", "0b11n", "0o17n", "1_000n", "123456789012345678901234567890n", "0xFFFFFFFFFFFFFFFFFFFFn"];
for (const lit of bigints) {
  setup(lit);
  eq("bigint token " + lit, lx.token, T_BIG_INT);
  eq("bigint value " + lit, atomText(), BigInt(lit.slice(0, -1).replace(/_/g, "")).toString());
}
setup("1a");
eq("1a is refused", lx.refusal, R_UNUSUAL_NUMBER);
setup("010");
eq("legacy octal refused without ecmascript", lx.refusal, R_UNUSUAL_NUMBER);
setup("010", false, DIALECT_ECMASCRIPT);
lx.configure(DIALECT_ECMASCRIPT, false, true, false, false);
setup("010");
lx.configure(DIALECT_ECMASCRIPT, false, true, false, false);
lx.begin(lx.src, 3);
lx.next();
eq("010 legacy octal (ecmascript js)", lx.number, 8);
eq("010 flagged", lx.flagged.len, 3);

// ───── names ─────
setup("\\u0061bc");
eq("escaped name token", lx.token, T_IDENTIFIER);
eq("escaped name atom", atomText(), "abc");
eq("escaped name hasEscape", lx.hasEscape, true);
setup("a\\u{62}c d");
eq("escaped name 2", atomText(), "abc");
eq("end", lx.end, 8);
setup("\\u0063onst");
eq("escaped keyword (typescript) is refused or escaped word", lx.refusal !== 0 || lx.token === T_ESCAPED_RESERVED_WORD, true);
setup("café x");
eq("unicode name", atomText(), "café");
setup("中文");
eq("cjk name", atomText(), "中文");
setup("#priv");
eq("private token", lx.token, T_PRIVATE_IDENTIFIER);
eq("private atom", atomText(), "#priv");
setup("const");
eq("keyword const", lx.token, T_CONST);
eq("keyword atom", atomText(), "const");
setup("function f");
eq("function", lx.token, T_FUNCTION);
lx.next();
eq("ident f", lx.token, T_IDENTIFIER);
setup("default");
eq("default atom is the known atom", lx.atom, A_default);
setup("constructor");
eq("constructor atom is the known atom", lx.atom, A_constructor);
setup("''");
eq("empty string atom is known", lx.atom, A_empty);
setup("await");
eq("await", lx.token, T_AWAIT);
// atom stability: same text, same atom; new text gets a number >= ATOM_FIXED
setup("foo foo bar thisIsAnIdentifierThatIsLongerThanTwelveBytes thisIsAnIdentifierThatIsLongerThanTwelveBytes thisIsAnIdentifierThatIsLongerThanTwelveByteZ");
const a1 = lx.atom;
lx.next();
eq("same atom", lx.atom, a1);
eq("fresh atom number", a1 >= ATOM_FIXED, true);
lx.next();
const bar = lx.atom;
eq("different atom", bar !== a1, true);
lx.next();
const long1 = lx.atom;
lx.next();
eq("long same atom", lx.atom, long1);
lx.next();
eq("long different atom (differs in the middle)", lx.atom !== long1, true);
eq("long atom text", atomText(), "thisIsAnIdentifierThatIsLongerThanTwelveByteZ");
// known atoms longer than 12 bytes live in names.cooked: a source name with the same text must find them
setup("NewableFunction LibraryManagedAttributes ElementAttributesProperty x");
eq("long known atom 1", lx.atom, A_NewableFunction);
lx.next();
eq("long known atom 2", lx.atom, A_LibraryManagedAttributes);
lx.next();
eq("long known atom 3", lx.atom, A_ElementAttributesProperty);
setup("'LibraryManagedAttributes' \\u0061bcdefghijklmnopqr abcdefghijklmnopqr 'abcdefghijklmnopqr'");
eq("long known atom as a string", lx.atom, A_LibraryManagedAttributes);
lx.next();
const decoded = lx.atom;
lx.next();
eq("a decoded long name and the same name in the source are one atom", lx.atom, decoded);
lx.next();
eq("... and the string with the same bytes", lx.atom, decoded);
// reset between files
setup("foo");
eq("atoms are per file: first name of the file", lx.atom, a1);

// ───── templates ─────
setup("`a${x}b${y}c`");
eq("template head", lx.token, T_TEMPLATE_HEAD);
eq("head atom", atomText(), "a");
lx.next();
lx.next();
eq("close brace", lx.token, T_CLOSE_BRACE);
lx.rescanTemplateContinuation();
eq("template middle", lx.token, T_TEMPLATE_MIDDLE);
eq("middle atom", atomText(), "b");
lx.next();
lx.next();
lx.rescanTemplateContinuation();
eq("template tail", lx.token, T_TEMPLATE_TAIL);
eq("tail atom", atomText(), "c");
setup("`a\\nb\r\nc\\u0041`");
eq("no-substitution template", lx.token, T_NO_SUBSTITUTION_TEMPLATE);
eq("cooked value (\\r\\n -> \\n)", atomText(), "a\nb\nc" + "A");
setup("`$ {x}`");
eq("dollar without brace", atomText(), "$ {x}");
setup("`\\unicode`");
eq("invalid escape in a template: no refusal, hasEscape (the parser decides)", lx.refusal === 0 && lx.hasEscape, true);
setup("`abc");
eq("unterminated template refused", lx.refusal, R_UNTERMINATED);

// ───── rescans ─────
setup("a >>>= b");
lx.next();
eq("> token", lx.token, T_GREATER_THAN);
lx.rescanGreaterThan();
eq(">>>= after rescan", lx.token, T_GREATER_THAN_GREATER_THAN_GREATER_THAN_EQUALS);
eq(">>>= end", lx.end, 6);
setup("a >> b");
lx.next();
lx.rescanGreaterThan();
eq(">> after rescan", lx.token, T_GREATER_THAN_GREATER_THAN);
setup("/ab[/]c\\/d/gi.test(x)");
eq("slash token", lx.token, T_SLASH);
lx.rescanSlash();
eq("regex token", lx.token, T_REGEX);
eq("regex end", lx.end, 13);

// ───── marks ─────
setup("a b c d");
const m1 = lx.mark();
lx.next();
lx.next();
const m2 = lx.mark();
lx.next();
lx.reset(m2);
eq("reset to c", lx.start, 4);
lx.reset(m1);
eq("reset to a", lx.start, 0);
eq("mark stack empty after reset", lx.markTop, 0);
const m3 = lx.mark();
lx.next();
lx.release(m3);
eq("release keeps the token", lx.start, 2);
eq("release pops", lx.markTop, 0);
// comments are forgotten by reset and found again
setup("a /* c1 */ b // c2\n c");
const mk = lx.mark();
lx.next();
lx.next();
eq("comments seen", lx.comments.len / 2, 2);
lx.reset(mk);
eq("comments forgotten by reset", lx.comments.len / 2, 0);
lx.next();
lx.next();
lx.next();
eq("comments found again", lx.comments.len / 2, 2);

// ───── comments, directives, trivia ─────
setup("// @ts-ignore\nx /* @ts-expect-error */ y /* multi\nline */ z");
eq("first token after comment", lx.start, 14);
eq("x newline before", lx.newlineBefore, true);
lx.next();
eq("y newline", lx.newlineBefore, false);
lx.next();
eq("z newline (comment has a line break)", lx.newlineBefore, true);
eq("comment count", lx.comments.len / 2, 3);
eq("directive count", lx.commentDirectives.len / 3, 2);
eq("directive kinds (ignore=1 then expect-error=0)", lx.commentDirectives.data[2] * 10 + lx.commentDirectives.data[5], 10);
eq("leading comments", lx.leadingComments.len / 2, 1);
setup("#!/usr/bin/env node\nx");
eq("hashbang skipped", lx.start, 20);
eq("hashbang is not a comment", lx.comments.len, 0);
setup("﻿x");
eq("BOM is trivia", lx.start, 3);
setup("a b");
lx.next();
eq("U+2028 is a line break", lx.newlineBefore, true);
setup("a b");
lx.next();
eq("nbsp is blank", lx.newlineBefore, false);
eq("b after nbsp", lx.start, 3);

// ───── operators ─────
const ops = "{ } ( ) [ ] . ... ; , < > <= >= == != === !== => + - * ** / % ++ -- << && || ?? ? : @ = += -= *= **= /= %= <<= &= |= ||= &&= ??= ^= & | ^ ! ~ ?. =>";
setup(ops);
let n = 0;
while (lx.token !== T_EOF && lx.refusal === 0) {
  n++;
  lx.next();
}
eq("operator count (>= is > then =: the parser rescans)", n, ops.split(" ").length + 1);
setup("a?.5:b");
lx.next();
eq("?.5 is ? then .5", lx.end, 2);
lx.next();
eq(".5 number", lx.token, T_NUMBER);

// ───── JSX ─────
function jsxText(text: string): string {
  setup(text, true);
  // scan from the beginning as a child
  lx.end = 0;
  lx.nextJsxChild();
  return lx.token === T_JSX_TEXT ? atomText() : "<token " + lx.token + ">";
}
eq("jsx plain", jsxText("hello world<"), "hello world");
eq("jsx trim lines", jsxText("  a  \n   b  \n  c  <"), "  a b c  ");
eq("jsx entities", jsxText("a &amp; b &lt; &#65; &#x42; &nbsp;<"), "a & b < A B  ");
eq("jsx unknown entity", jsxText("a &bogus; b<"), "a &bogus; b");
jsxText("\n   \n  <");
eq("jsx all whitespace with line break is no child: the next token is `<`", lx.token, T_LESS_THAN);
setup("<a  b-c=\"x'y\" d='z' e={f}>text {g}</a>", true);
eq("jsx <", lx.token === T_LESS_THAN, true);
lx.next();
lx.scanJsxIdentifier();
eq("tag a", atomText(), "a");
lx.next();
lx.scanJsxIdentifier();
eq("attribute with dash", atomText(), "b-c");
lx.next(); // =
lx.scanJsxAttributeValue();
eq("jsx attr string token", lx.token, T_STRING);
eq("jsx attr string value", atomText(), "x'y");
lx.next();
lx.scanJsxIdentifier();
eq("attr d", atomText(), "d");
lx.next();
lx.scanJsxAttributeValue();
eq("jsx attr single-quoted", atomText(), "z");
lx.next();
lx.scanJsxIdentifier();
eq("attr e", atomText(), "e");
lx.next();
lx.scanJsxAttributeValue();
eq("jsx attr brace", lx.token, T_OPEN_BRACE);
void T_DEFAULT;

console.log(failures === 0 ? "lex-unit: all " + checks + " checks passed" : "lex-unit: " + failures + " of " + checks + " FAILED");
if (failures !== 0) process.exitCode = 1;
